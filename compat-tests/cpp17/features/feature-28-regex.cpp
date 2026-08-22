#include <iostream>
#include <regex>
#include <string>
int main(){ std::cout<<std::regex_match(std::string("c17"),std::regex("c[0-9]+"))<<"\n"; }
