# openleetcode.py

import argparse
import json
import logger
import os
import re
import shutil
import subprocess
import sys

import testrunner
import functionextractor
import resultsvalidator

TESTCAST_OUTPUT_DIR = "testcase_output"
VALIDATION_SCHEMA_FILE_NAME = "results_validation_schema.json"

def naturalSort(s):
    return [int(text) if text.isdigit() else text.lower()
            for text in re.split('([0-9]+)', s)]

def run(command, directory):
    logger.log("Running command: " + command)
    result = subprocess.run(command,
                        stdout=subprocess.PIPE,
                        stderr=subprocess.STDOUT,
                        shell=True,
                        cwd=directory)
    logger.log(result.stdout.decode('utf-8'))
    if result.returncode != 0:
        logger.log(f"Error running the command: {command}")
    return result.returncode

def getExeExtension():
    if os.name == 'posix':
        return ""
    elif os.name == 'nt':
        return ".exe"
    else:
        return ""

def main():
    parser = argparse.ArgumentParser(
        description="OpenLeetCode problem builder. This script builds and "
                    "tests a LeetCode-like problems locally. Currently, it "
                    "only supports C++ language, but it can be extended to "
                    "support other languages.")
    parser.add_argument(
        "--language", "-l",
        choices=['cpp'],
        default="cpp",
        help="The programming language.")
    parser.add_argument(
        "--list-problems",
        action="store_true",
        default=False,
        help="List problems.")
    parser.add_argument(
        "--list-testcases",
        action="store_true",
        default=False,
        help="List testcases for a problem specified with '--problem' option.")
    parser.add_argument(
        "--problem", "-p",
        metavar='problem_name',
        default="TwoSum",
        type=str,
        help="Name of the problem to build and test. Default: TwoSum. Use "
        "--list-problems to list all problems.")
    parser.add_argument(
        "--problem_builds_dir", "-d",
        metavar='dir', 
        type=str, 
        help=("Specifies the directory with the problems. Typically, this is "
            "'./problem_builds'. If not provided, the script defaults to "
            "'./problem_builds' in the same directory as the executable."))
    parser.add_argument(
        "--run-expected-tests", "-r",
        action="store_true",
        default=False,
        help="Run the expected solution. Default: False.")
    parser.add_argument(
        "--testcase", "-t",
        metavar='testcase_name',
        default="All",
        type=str,
        help="Name of the testcase to run. '--testcase All' will run all "
        "testcases. Default: All.")
    parser.add_argument("--verbose", "-v",
                        action="store_true",
                        default=False,
                        help="Print verbose output")
    
    args = parser.parse_args()

    logger.set_verbose(args.verbose)

    openleetcode_dir = os.path.dirname(os.path.realpath(__file__))
    if args.problem_builds_dir is None:
        
        problem_builds_dir = openleetcode_dir
    else:
        problem_builds_dir = os.path.abspath(args.problem_builds_dir)

    if not os.path.isdir(problem_builds_dir):
        print(logger.red(f"The problems directory {problem_builds_dir} "
                         f"does not exist."))
        sys.exit(1)

    problems_dir = os.path.abspath(os.path.join(problem_builds_dir, "problems"))

    if not os.path.isdir(problems_dir):
        print(logger.red(f"The problems directory {problems_dir} does not exist."))
        sys.exit(1)

    if (args.list_problems):
        print("List of problems:")
        for problem in os.listdir(problems_dir):
            print(problem)
        sys.exit(1)

    problem_dir = os.path.join(problem_builds_dir, "problems", args.problem)
    if not os.path.isdir(problem_dir):
        print(logger.red(f"The problem directory {problem_dir} does not exist. "
                         f"Check the problem_builds_dir and problem "
                         f"arguments."))
        sys.exit(1)

    src_template_dir = os.path.join(problem_builds_dir, "languages",
                                    args.language)
    if not os.path.isdir(src_template_dir):
        print(logger.red(f"The source template directory {src_template_dir} "
                         f"does not exist. This usually happen when the "
                         f"language is not supported. Check the language "
                         f"argument."))
        sys.exit(1)

    src_dir = os.path.abspath(os.path.join(problem_dir, args.language))
    if not os.path.isdir(src_dir):
        print(logger.red(f"The source directory {src_dir} does not exist. This"
                         f" usually happen when the language is not supported."
                         f" Check the language argument."))
        sys.exit(1)

    build_dir = os.path.abspath(os.path.join(src_dir, "build"))
    
    testcases_dir = os.path.abspath(os.path.join(src_dir, "../testcases"))

    if (args.list_testcases):
        print("List of testcases:")
        for testcase in sorted(os.listdir(testcases_dir), key=naturalSort):
            print(testcase.replace(".test", ""))
        sys.exit(0)
    
    if (args.testcase != "All"):
        testcase_file = os.path.join(testcases_dir, args.testcase + ".test")
        if not os.path.isfile(testcase_file):
            print(logger.red(f"The testcase file {testcase_file} does not "
                             "exist."))
            sys.exit(1)

    print("Running OpenLeetCode on problem " + args.problem +
          " for testcase " + args.testcase + " in language " + args.language)
    logger.log(f"Building the problem {args.problem} "
               f"in {args.language} language.")
    logger.log(f"OpenLeetCode directory: {openleetcode_dir}")
    logger.log(f"Problem directory: {problem_dir}")
    logger.log(f"Problems directory: {problems_dir}")
    logger.log(f"Problem builds directory: {problem_builds_dir}")
    logger.log(f"Source directory: {src_dir}")
    logger.log(f"Build directory: {build_dir}")
    logger.log(f"Template source directory: {src_template_dir}")
    logger.log(f"Testcases directory: {testcases_dir}")

    # Copy the template source files to the problem directory if they don't
    # already exist
    for file in os.listdir(src_template_dir):
        src_file = os.path.join(src_template_dir, file)
        dst_file = os.path.join(src_dir, file)
        if not os.path.isfile(dst_file):
            logger.log(f"Copying {src_file} to {dst_file}")
            shutil.copy(src_file, dst_file)
    
    solution_file_name = os.path.join(src_dir, "solution.cpp")
    solution_function_file_name = os.path.join(src_dir, "solutionfunction.h")
    if not os.path.isfile(solution_function_file_name):
        ret = functionextractor.get_function(solution_file_name,
                                            solution_function_file_name)
        logger.log(f"Extracted function name: {ret}")
        logger.log(f"Writing the function name to {solution_function_file_name}")

        if not ret:
            print(logger.red(f"Could not extract the function name from "
                            f"{solution_file_name}."))
            sys.exit(1)

    validation_schema_file = os.path.abspath(
        os.path.join(openleetcode_dir, VALIDATION_SCHEMA_FILE_NAME))
    if not os.path.isfile(validation_schema_file):
        print(logger.red(f"The validation schema file {validation_schema_file} "
                         f"does not exist."))
        sys.exit(1)
    
    with open(validation_schema_file, 'r') as f:
        try:
            schema = json.load(f)
        except Exception as e:
            print(logger.red(f"Error reading the validation schema file. "
                             f"error={e}"))
            sys.exit(1)
        resultsvalidator.set_schema(schema)

    if not os.path.isfile(os.path.join(build_dir, "CMakeCache.txt")):
        print("CMakeCache.txt does not exist. Running CMake to configure the ")
        if run(f"cmake -B {build_dir}  -DCMAKE_BUILD_TYPE=Debug", src_dir) != 0:
            print(logger.red(f"CMake failed!"))
            sys.exit(1)
    else:
        print("CMakeCache.txt exists. Skipping CMake configuration.")

    if run(f"cmake --build . --config Debug -j", build_dir) != 0:
        print(logger.red("Build failed!"))
        sys.exit(1)

    if run(f"cmake --install . --config Debug -v", build_dir) != 0:
        print(logger.red("Cmake install failed!"))
        sys.exit(1)

    bin_dir = os.path.abspath(os.path.join(src_dir, "bin"))
    
    if not os.path.isdir(bin_dir):
        print(logger.red(f"The bin directory {bin_dir} does not exist. Check "
                          "the problem_builds_dir and problem arguments."))
        sys.exit(1)
    
    exe_file_name = (
        "solution_expected_" 
        if args.run_expected_tests 
        else "solution_"
    )

    exe_file = os.path.abspath(os.path.join(
        bin_dir, f"{exe_file_name}{args.language}" + getExeExtension()))
    
    if not os.path.isfile(exe_file):
        print(logger.red(f"The file {exe_file} does not exist. Check the "
                         f"problem_builds_dir and problem arguments."))
        sys.exit(1)

    if not os.path.isdir(testcases_dir):
        print(logger.red(f"The test directory {testcases_dir} does not exist. "
                         f"Check the problem_builds_dir and problem "
                         f"arguments."))
        sys.exit(1)
    
    if not os.path.isdir(TESTCAST_OUTPUT_DIR):
        os.mkdir(TESTCAST_OUTPUT_DIR)

    output_file_dir = os.path.abspath(os.path.join(TESTCAST_OUTPUT_DIR))

    ret, error_message = testrunner.runTests(exe_file,
                                             testcases_dir,
                                             output_file_dir,
                                             args.problem,
                                             args.testcase)

    if ret != 0:
        print(logger.red(f"Tests failed! Error: {error_message}"))
        sys.exit(1)

if __name__ == "__main__":
    main()